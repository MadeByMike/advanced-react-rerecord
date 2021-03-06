import { promisify } from 'util';
import { randomBytes } from 'crypto';
import stripe from './stripe';
import { transport, makeANiceEmail } from './src/mail';

export async function addToCart(parent, args, ctx, info, { query }) {
  // 1. Make sure they are signed in
  const { id: userId } = ctx.authedItem;
  if (!userId) {
    throw new Error('You must be signed in soooon');
  }
  // 2. Query the users current cart
  const {
    data: { allCartItems },
  } = await query(`
    query {
      allCartItems(where: {
          user: { id: "${userId}" },
          item: { id: "${args.id}" },
      }) {
        id
        quantity
      }
    }
  `);

  const [existingCartItem] = allCartItems;

  // 3. Check if that item is already in their cart and increment by 1 if it is
  if (existingCartItem) {
    console.log(
      `There are already ${existingCartItem.quantity} if these items in their cart`
    );
    const res = await query(
      `
      mutation {
        updateCartItem(
          id: "${existingCartItem.id}",
          data: { quantity: ${existingCartItem.quantity + 1}}
        ) {
          id
          quantity
        }
      }
    `,
      { context: ctx }
    );
    return res.data.updateCartItem;
  }
  // 4. If its not, create a fresh CartItem for that user!
  // TODO Can we get highlighting here?
  // TODO Change this to proper GraphQL variables
  // TODO How do we pass `info.fields` to this query? there needs to be something easy..
  // TODO this breaks if we query the user { id }
  const CREATE_CART_ITEM_MUTATION = `
    mutation {
      createCartItem(data: {
        item: { connect: { id: "${args.id}" }},
        user: { connect: { id: "${userId}" }}
      }) {
        id
        quantity
      }
    }
  `;
  const res = await query(CREATE_CART_ITEM_MUTATION, {
    context: ctx,
  });
  return res.data.createCartItem;
}

export async function checkout(parent, args, ctx, info, { query }) {
  // 1. Query the current user and make sure they are signed in
  const { id: userId } = ctx.authedItem;
  if (!userId) throw new Error('You must be signed in to complete this order.');

  const {
    data: { User },
  } = await query(`
    query {
      User(where: { id: "5de9a29642ca551f24c596ba" }) {
        id
        name
        email
        cart {
          id
          quantity
          item { name price id description image { publicUrlTransformed } }
        }
      }
    }
  `);
  // 2. recalculate the total for the price
  const amount = User.cart.reduce(
    (tally, cartItem) => tally + cartItem.item.price * cartItem.quantity,
    0
  );
  console.log(`Going to charge for a total of ${amount}`);
  // 3. Create the stripe charge (turn token into $$$)
  const charge = await stripe.charges.create({
    amount,
    currency: 'USD',
    source: args.token,
  });
  // console.log(charge);
  // 4. Convert the CartItems to OrderItems
  const orderItems = User.cart.map(cartItem => {
    const orderItem = {
      ...cartItem.item,
      quantity: cartItem.quantity,
      // TODO is this line needed?
      user: { connect: { id: userId } },
      image: cartItem.item.image.publicUrlTransformed,
    };
    delete orderItem.id;
    delete orderItem.user;
    return orderItem;
  });

  // 5. create the Order
  console.log('Creating the order');
  const order = await query(
    `
      mutation createOrder($orderItems: [OrderItemCreateInput]) {
        createOrder(
          data: {
            total: ${charge.amount},
            charge: "${charge.id}",
            items: { create: $orderItems },
            user: { connect: { id: "${userId}" } },
          }
          ) {
            id
          }
        }
        `,
    { variables: { orderItems } }
  );

  // 6. Clean up - clear the users cart, delete cartItems
  const cartItemIds = User.cart.map(cartItem => cartItem.id);
  console.log(cartItemIds);
  const deleteResponse = await query(
    `
    mutation deleteCartItems($ids: [ID!]) {
      deleteCartItems(ids: $ids) {
        id
      }
    }
  `,
    { variables: { ids: cartItemIds } }
  );
  // 7. Return the Order to the client
  return order.data.createOrder;
}

export async function requestReset(parent, args, ctx, info, { query }) {
  // 1. Check if this is a real user
  const response = await query(
    `query {
      allUsers(where: { email: "${args.email}" }) {
        email
        id
      }
    }`
  );

  const [user] = response.data.allUsers;
  if (!user) {
    throw new Error(`No such user found for email ${args.email}`);
  }
  // 2. Set a reset token and expiry on that user
  const resetToken = (await promisify(randomBytes)(20)).toString('hex');
  const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now
  const updateResponse = await query(`mutation {
    updateUser(
      id: "${user.id}",
      data: { resetToken: "${resetToken}", resetTokenExpiry: "${resetTokenExpiry}" },
    ) {
      email
      resetToken
      resetTokenExpiry
    }
  }`);

  // 3. Email them that reset token
  const mailRes = await transport.sendMail({
    from: 'wes@wesbos.com',
    to: user.email,
    subject: 'Your Password Reset Token',
    html: makeANiceEmail(`Your Password Reset Token is here!
      \n\n
      <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`),
  });

  // 4. Return the message
  return { message: 'Check your email son!' };
}

export async function resetPassword(parent, args, ctx, info, { query }) {
  console.log(args);
  // 1. check if the passwords match
  console.info('1. Checking is passwords match');
  if (args.password !== args.confirmPassword) {
    throw new Error("Yo Passwords don't match!");
  }
  // 2. check if its a legit reset token
  console.info('1. Checking if legit token');
  const userResponse = await query(`query {
    allUsers(where: {
      resetToken: "${args.resetToken}",
    }) {
      id
      resetTokenExpiry
    }
  }`);
  const [user] = userResponse.data.allUsers;
  if (!user) {
    throw new Error('This token is invalid.');
  }
  // 3. Check if its expired
  console.info('check if expired');
  const now = Date.now();
  const expiry = new Date(user.resetTokenExpiry).getTime();
  if (now - expiry > 3600000) {
    throw new Error('This token is expired');
  }
  // 4. Save the new password to the user and remove old resetToken fields
  console.log(`4. Saving new password`);
  const updatedUserResponse = await query(`
    mutation {
      updateUser(
        id: "${user.id}",
        data: {
          password: "${args.password}",
          resetToken: null,
          resetTokenExpiry: null,
        }
      ) {
        password_is_set
        name
      }
    }
  `);
  const { errors, data } = updatedUserResponse;
  // TODO: Is this okay? I'd like to throw just the error if possible
  // this shows me things like "[password:minLength:User:password] Value must be at least 8 characters long. \n\nGraphQL request:3:7\n2 |     mutation {\n3 |       updateUser(\n  |       ^\n4 |         id: \"5de9a29642ca551f24c596ba\
  if (errors) {
    throw new Error(errors);
  }
  console.info('Sending success response');
  return {
    message: 'Your password has been reset',
  };
}
